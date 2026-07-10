'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Megaphone, Plus, Send, Ban, Users, TicketPercent, Download, CheckCircle2, Sparkles, Square } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
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
import { Select } from '@/components/form-controls';

const tone: Record<string, any> = { draft: 'muted', scheduled: 'info', sent: 'success', cancelled: 'destructive' };
const vtone: Record<string, any> = { PendingApproval: 'warning', Active: 'success', Rejected: 'destructive', Ended: 'muted' };

interface Campaign { id: number; campaign_code: string; name: string; channel: string; audience: string; segment: string | null; tier: string | null; saved_segment_id: number | null; status: string; targeted: number; sent_count: number; skipped_count: number; failed_count: number; schedule_at: string | null }
interface SavedSegment { id: number; name: string }
interface VoucherCampaign { id: number; campaign_code: string; name: string; kind: string; value: number; min_spend: number | null; valid_to: string | null; per_code_max_uses: number; max_redemptions: number | null; status: string; codes_issued: number; redeemed_count: number; created_by: string | null; approved_by: string | null }

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

  // ── POS-3 voucher campaigns (codes redeemable at POS checkout; activation is maker-checker) ──
  const vlist = useQuery<{ campaigns: VoucherCampaign[] }>({ queryKey: ['voucher-campaigns'], queryFn: () => api('/api/vouchers/campaigns') });
  const [vf, setVf] = useState({ name: '', kind: 'percent', value: '', min_spend: '', valid_to: '', per_code_max_uses: '1', max_redemptions: '' });
  const vset = (p: Partial<typeof vf>) => setVf((s) => ({ ...s, ...p }));
  const [genCount, setGenCount] = useState('100');
  const vRefresh = () => qc.invalidateQueries({ queryKey: ['voucher-campaigns'] });
  const vCreate = useMutation({
    mutationFn: () => api('/api/vouchers/campaigns', { method: 'POST', body: JSON.stringify({
      name: vf.name, kind: vf.kind, value: Number(vf.value),
      ...(vf.min_spend ? { min_spend: Number(vf.min_spend) } : {}), ...(vf.valid_to ? { valid_to: vf.valid_to } : {}),
      ...(vf.per_code_max_uses ? { per_code_max_uses: Number(vf.per_code_max_uses) } : {}), ...(vf.max_redemptions ? { max_redemptions: Number(vf.max_redemptions) } : {}),
    }) }),
    onSuccess: () => { notifySuccess(t('ly.vc_created')); setVf({ name: '', kind: 'percent', value: '', min_spend: '', valid_to: '', per_code_max_uses: '1', max_redemptions: '' }); vRefresh(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const vApprove = useMutation({ mutationFn: (c: VoucherCampaign) => api(`/api/vouchers/campaigns/${c.id}/approve`, { method: 'POST' }), onSuccess: () => { notifySuccess(t('ly.vc_approved')); vRefresh(); }, onError: (e: Error) => notifyError(e.message) });
  const vReject = useMutation({ mutationFn: (c: VoucherCampaign) => api(`/api/vouchers/campaigns/${c.id}/reject`, { method: 'POST', body: '{}' }), onSuccess: vRefresh, onError: (e: Error) => notifyError(e.message) });
  const vEnd = useMutation({ mutationFn: (c: VoucherCampaign) => api(`/api/vouchers/campaigns/${c.id}/end`, { method: 'POST' }), onSuccess: vRefresh, onError: (e: Error) => notifyError(e.message) });
  const vGen = useMutation({
    mutationFn: (c: VoucherCampaign) => api<{ generated: number }>(`/api/vouchers/campaigns/${c.id}/codes`, { method: 'POST', body: JSON.stringify({ count: Math.max(1, Number(genCount) || 1) }) }),
    onSuccess: (r) => { notifySuccess(t('ly.vc_generated', { count: r.generated })); vRefresh(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const vCsv = (c: VoucherCampaign) => apiDownload(`/api/vouchers/campaigns/${c.id}/codes.csv`, `voucher-codes-${c.campaign_code}.csv`).catch((e: Error) => notifyError(e.message));

  return (
    <div>
      <PageHeader title={t('ly.lc_title')} description={t('ly.lc_desc')} actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.lc_create')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label>{t('ly.campaign_name')}</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.lc_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.lc_channel')}</Label><Select className="w-auto" value={f.channel} onChange={(e) => set({ channel: e.target.value })}><option value="sms">SMS</option><option value="email">Email</option><option value="line">LINE</option></Select></div>
              <div className="grid gap-1.5"><Label>{t('ly.mk_target_group')}</Label><Select className="w-auto" value={f.audience} onChange={(e) => set({ audience: e.target.value })}><option value="all">{t('ly.mk_trig_all')}</option><option value="segment">{t('ly.seg_f_segment')}</option><option value="saved_segment">{t('ly.lc_aud_saved')}</option><option value="tier">{t('ly.seg_f_tier')}</option><option value="birthdays_today">{t('ly.lc_aud_bday')}</option></Select></div>
              {f.audience === 'segment' && <div className="grid gap-1.5"><Label>{t('ly.seg_f_segment')}</Label><Input value={f.segment} onChange={(e) => set({ segment: e.target.value })} placeholder={t('ly.seg_value_ph')} /></div>}
              {f.audience === 'tier' && <div className="grid gap-1.5"><Label>{t('ly.lc_tier')}</Label><Input value={f.tier} onChange={(e) => set({ tier: e.target.value })} placeholder={t('ly.lc_tier_ph')} /></div>}
              {f.audience === 'saved_segment' && <div className="grid gap-1.5"><Label>{t('ly.lc_segment')}</Label><Select className="w-auto" value={f.saved_segment_id} onChange={(e) => set({ saved_segment_id: e.target.value })}><option value="">{t('ly.lc_select_segment')}</option>{(segs.data?.segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}</Select></div>}
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

        {/* ── POS-3 voucher campaigns: standalone codes redeemable at POS checkout ── */}
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TicketPercent className="size-4" /> {t('ly.vc_title')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('ly.vc_desc')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label>{t('ly.vc_name')}</Label><Input value={vf.name} onChange={(e) => vset({ name: e.target.value })} placeholder={t('ly.vc_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.vc_kind')}</Label><Select className="w-auto" value={vf.kind} onChange={(e) => vset({ kind: e.target.value })}><option value="percent">{t('ly.vc_kind_percent')}</option><option value="amount">{t('ly.vc_kind_amount')}</option></Select></div>
              <div className="grid gap-1.5"><Label>{t('ly.vc_value')}</Label><Input type="number" min={0} className="tabular" value={vf.value} onChange={(e) => vset({ value: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.vc_min_spend')}</Label><Input type="number" min={0} className="tabular" value={vf.min_spend} onChange={(e) => vset({ min_spend: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.vc_valid_to')}</Label><Input type="date" value={vf.valid_to} onChange={(e) => vset({ valid_to: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.vc_max_redemptions')}</Label><Input type="number" min={1} className="tabular" value={vf.max_redemptions} onChange={(e) => vset({ max_redemptions: e.target.value })} placeholder={t('ly.vc_unlimited')} /></div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => vCreate.mutate()} disabled={!vf.name.trim() || !Number(vf.value) || vCreate.isPending}><Plus className="size-4" /> {vCreate.isPending ? t('ly.saving') : t('ly.vc_create')}</Button>
              <span className="text-xs text-muted-foreground">{t('ly.vc_sod_note')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label className="text-muted-foreground">{t('ly.vc_gen_count')}</Label>
              <Input type="number" min={1} max={2000} className="h-8 w-24 tabular" value={genCount} onChange={(e) => setGenCount(e.target.value)} />
            </div>
            <StateView q={vlist}>
              {vlist.data && (
                <DataTable
                  rows={vlist.data.campaigns}
                  rowKey={(c) => c.id}
                  emptyState={{ icon: TicketPercent, title: t('ly.vc_empty'), description: t('ly.vc_empty_desc') }}
                  columns={[
                    { key: 'campaign_code', label: t('ly.col_code'), render: (c) => <span className="font-mono text-xs">{c.campaign_code}</span> },
                    { key: 'name', label: t('ly.col_name') },
                    { key: 'value', label: t('ly.vc_col_discount'), align: 'right', render: (c) => <span className="tabular">{c.kind === 'percent' ? `${num(c.value)}%` : `฿${num(c.value)}`}{c.min_spend ? <span className="text-xs text-muted-foreground"> ≥฿{num(c.min_spend)}</span> : null}</span> },
                    { key: 'status', label: t('fin.col_status'), render: (c) => <Badge variant={vtone[c.status] ?? 'muted'}>{c.status}</Badge> },
                    { key: 'codes_issued', label: t('ly.vc_col_codes'), align: 'right', render: (c) => <span className="tabular text-xs">{num(c.redeemed_count)}/{num(c.codes_issued)}</span> },
                    { key: 'act', label: '', align: 'right', render: (c) => (
                      <div className="flex justify-end gap-1">
                        {c.status === 'PendingApproval' && (
                          <>
                            <Button size="sm" variant="outline" disabled={vApprove.isPending} onClick={() => vApprove.mutate(c)}><CheckCircle2 className="size-3.5" /> {t('ly.vc_approve')}</Button>
                            <Button size="sm" variant="ghost" disabled={vReject.isPending} onClick={() => vReject.mutate(c)}><Ban className="size-3.5" /></Button>
                          </>
                        )}
                        {(c.status === 'PendingApproval' || c.status === 'Active') && (
                          <Button size="sm" variant="outline" disabled={vGen.isPending} onClick={() => vGen.mutate(c)}><Sparkles className="size-3.5" /> {t('ly.vc_generate')}</Button>
                        )}
                        {c.codes_issued > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => vCsv(c)} aria-label={t('ly.vc_export_csv')}><Download className="size-3.5" /></Button>
                        )}
                        {c.status === 'Active' && (
                          <Button size="sm" variant="ghost" disabled={vEnd.isPending} onClick={() => vEnd.mutate(c)} aria-label={t('ly.vc_end')}><Square className="size-3.5" /></Button>
                        )}
                      </div>
                    ) },
                  ]}
                />
              )}
            </StateView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
