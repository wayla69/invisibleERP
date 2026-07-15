'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star, MapPin, BarChart3, RefreshCw, Unplug, Settings2, MessageSquareReply, TrendingUp, Users, Wallet, AlarmClock, Clock, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface Connection {
  id: number; platform: 'google_maps' | 'google_analytics'; status: string;
  google_account_email: string | null; external_refs: { ref: string; label: string }[];
  last_synced_at: string | null; last_error: string | null; has_refresh_token: boolean;
}
interface Target { ref: string; label: string }

const PLATFORM_LABEL: Record<string, string> = { google_maps: 'Google Maps', google_analytics: 'Google Analytics (GA4)' };

function ConnectionCard({ platform, conn, onChanged }: { platform: 'google_maps' | 'google_analytics'; conn?: Connection; onChanged: () => void }) {
  const { t } = useLang();
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const targetsQ = useQuery<{ targets: Target[] }>({
    queryKey: ['rep-targets', conn?.id], queryFn: () => api(`/api/reputation/connections/${conn!.id}/targets`),
    enabled: targetsOpen && !!conn, retry: false,
  });

  const connect = useMutation({
    mutationFn: () => api<{ authorization_url: string }>(`/api/reputation/oauth/start?platform=${platform}`),
    onSuccess: (r) => { window.location.href = r.authorization_url; },
    onError: (e: any) => notifyError(e.message),
  });
  const syncNow = useMutation({
    mutationFn: () => api(`/api/reputation/sync/${platform}`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('rep.synced')); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => api(`/api/reputation/connections/${conn!.id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('rep.disconnected')); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const saveTargets = useMutation({
    mutationFn: () => api(`/api/reputation/connections/${conn!.id}/targets`, { method: 'PUT', body: JSON.stringify({ targets: (targetsQ.data?.targets ?? []).filter((tg) => selected.has(tg.ref)) }) }),
    onSuccess: () => { notifySuccess(t('rep.targets_saved')); setTargetsOpen(false); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });

  const openTargets = () => {
    setSelected(new Set((conn?.external_refs ?? []).map((r) => r.ref)));
    setTargetsOpen(true);
  };

  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{PLATFORM_LABEL[platform]}</CardTitle>
        {conn && <Badge variant={statusVariant(conn.status === 'active' ? 'Active' : conn.status)}>{conn.status}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {!conn || conn.status === 'revoked' ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('rep.not_connected')}</p>
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>{t('rep.connect')}</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">{conn.google_account_email ?? '—'}</p>
            <p className="text-xs text-muted-foreground">
              {conn.external_refs.length} {t('rep.targets_tracked')} · {conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : t('rep.never_synced')}
            </p>
            {conn.last_error && <p className="text-xs text-destructive">{conn.last_error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={openTargets}><Settings2 className="mr-1 size-3.5" />{t('rep.manage_targets')}</Button>
              <Button size="sm" variant="secondary" disabled={syncNow.isPending || conn.external_refs.length === 0} onClick={() => syncNow.mutate()}><RefreshCw className="mr-1 size-3.5" />{t('rep.sync_now')}</Button>
              <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}><Unplug className="mr-1 size-3.5" />{t('rep.disconnect')}</Button>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={targetsOpen} onOpenChange={setTargetsOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('rep.targets_dlg_title')}</DialogTitle></DialogHeader>
          <StateView q={targetsQ}>
            {targetsQ.data && (
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {targetsQ.data.targets.length === 0 && <p className="text-sm text-muted-foreground">{t('rep.no_targets_found')}</p>}
                {targetsQ.data.targets.map((tg) => (
                  <label key={tg.ref} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(tg.ref)}
                      onChange={(e) => setSelected((prev) => { const next = new Set(prev); if (e.target.checked) next.add(tg.ref); else next.delete(tg.ref); return next; })}
                    />
                    {tg.label}
                  </label>
                ))}
              </div>
            )}
          </StateView>
          <DialogFooter>
            <Button disabled={saveTargets.isPending} onClick={() => saveTargets.mutate()}>{t('rep.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Connections() {
  const q = useQuery<{ connections: Connection[] }>({ queryKey: ['rep-connections'], queryFn: () => api('/api/reputation/connections') });
  const qc = useQueryClient();
  const onChanged = () => qc.invalidateQueries({ queryKey: ['rep-connections'] });
  const byPlatform = (p: string) => q.data?.connections.find((c) => c.platform === p);
  return (
    <StateView q={q}>
      <div className="grid gap-4 sm:grid-cols-2">
        <ConnectionCard platform="google_maps" conn={byPlatform('google_maps')} onChanged={onChanged} />
        <ConnectionCard platform="google_analytics" conn={byPlatform('google_analytics')} onChanged={onChanged} />
      </div>
    </StateView>
  );
}

function ReplyDialog({ reviewId, onClose, onSaved }: { reviewId: number | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [comment, setComment] = useState('');
  const reply = useMutation({
    mutationFn: () => api(`/api/reputation/reviews/${reviewId}/reply`, { method: 'POST', body: JSON.stringify({ comment }) }),
    onSuccess: () => { notifySuccess(t('rep.reply_sent')); setComment(''); onSaved(); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Dialog open={reviewId != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('rep.reply_dlg_title')}</DialogTitle></DialogHeader>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={5} placeholder={t('rep.reply_ph')} className="min-h-24 w-full rounded border p-2 text-sm" />
        <DialogFooter>
          <Button disabled={!comment.trim() || reply.isPending} onClick={() => reply.mutate()}>{t('rep.send_reply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Reviews() {
  const { t } = useLang();
  const [needsAttention, setNeedsAttention] = useState(false);
  const [replyId, setReplyId] = useState<number | null>(null);
  const qc = useQueryClient();
  const q = useQuery<{ count: number; reviews: any[] }>({
    queryKey: ['rep-reviews', needsAttention],
    queryFn: () => api(`/api/reputation/reviews${needsAttention ? '?needs_attention=1' : ''}`),
  });
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button size="sm" variant={!needsAttention ? 'default' : 'secondary'} onClick={() => setNeedsAttention(false)}>{t('rep.filter_all')}</Button>
        <Button size="sm" variant={needsAttention ? 'default' : 'secondary'} onClick={() => setNeedsAttention(true)}>{t('rep.filter_needs_attention')}</Button>
      </div>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.reviews} rowKey={(r: any) => r.id} emptyState={{ icon: Star, title: t('rep.no_reviews') }} columns={[
            { key: 'author', label: t('rep.col_author'), render: (r: any) => r.author_name ?? '—' },
            { key: 'rating', label: t('rep.col_rating'), render: (r: any) => r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '—' },
            { key: 'comment', label: t('rep.col_comment'), render: (r: any) => <span className="line-clamp-2 max-w-md">{r.comment ?? '—'}</span> },
            { key: 'date', label: t('rep.col_date'), render: (r: any) => r.review_create_time ? new Date(r.review_create_time).toLocaleDateString() : '—' },
            { key: 'reply', label: t('rep.col_reply'), render: (r: any) => r.reply_comment ? <Badge variant="success">{t('rep.replied')}</Badge> : <Button size="sm" variant="secondary" onClick={() => setReplyId(r.id)}><MessageSquareReply className="mr-1 size-3.5" />{t('rep.reply')}</Button> },
          ]} />
        )}
      </StateView>
      <ReplyDialog reviewId={replyId} onClose={() => setReplyId(null)} onSaved={() => { setReplyId(null); qc.invalidateQueries({ queryKey: ['rep-reviews'] }); }} />
    </div>
  );
}

function AnalyticsPanel() {
  const { t } = useLang();
  const summaryQ = useQuery<any>({ queryKey: ['rep-summary'], queryFn: () => api('/api/bi/reputation-summary?days=30') });
  const seriesQ = useQuery<{ count: number; days: any[] }>({ queryKey: ['rep-analytics'], queryFn: () => api('/api/reputation/analytics?days=30') });
  const d = summaryQ.data;
  return (
    <div className="space-y-4">
      <StateView q={summaryQ}>
        {d && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('rep.avg_rating')} value={d.avg_rating != null ? String(d.avg_rating) : '—'} icon={Star} tone="warning" />
            <StatCard label={t('rep.needs_attention')} value={num(d.needs_attention)} icon={MapPin} tone={d.needs_attention > 0 ? 'danger' : 'success'} />
            <StatCard label={t('rep.ga4_sessions')} value={num(d.analytics?.sessions)} icon={Users} tone="primary" />
            <StatCard label={t('rep.ga4_revenue')} value={baht(d.analytics?.revenue)} icon={Wallet} tone="success" />
          </div>
        )}
      </StateView>
      <StateView q={seriesQ}>
        {seriesQ.data && (
          <DataTable rows={seriesQ.data.days} rowKey={(r: any) => `${r.property_ref}-${r.metric_date}`} emptyState={{ icon: BarChart3, title: t('rep.no_analytics') }} columns={[
            { key: 'date', label: t('rep.col_date'), render: (r: any) => r.metric_date },
            { key: 'sessions', label: t('rep.col_sessions'), align: 'right', render: (r: any) => num(r.sessions) },
            { key: 'users', label: t('rep.col_users'), align: 'right', render: (r: any) => num(r.active_users) },
            { key: 'conversions', label: t('rep.col_conversions'), align: 'right', render: (r: any) => num(r.conversions) },
            { key: 'revenue', label: t('rep.col_revenue'), align: 'right', render: (r: any) => baht(r.total_revenue) },
            { key: 'channel', label: t('rep.col_top_channel'), render: (r: any) => r.top_channel_group ?? '—' },
          ]} />
        )}
      </StateView>
    </div>
  );
}

function SlaPanel() {
  const { t } = useLang();
  const qc = useQueryClient();
  const settingsQ = useQuery<{ sla_rating_threshold: number; sla_hours: number; is_default: boolean; updated_by: string | null }>({
    queryKey: ['rep-sla-settings'], queryFn: () => api('/api/reputation/response-settings'),
  });
  const slaQ = useQuery<{ settings: { sla_rating_threshold: number; sla_hours: number }; breach_count: number; open_count: number; breaches: any[]; open: any[] }>({
    queryKey: ['rep-sla'], queryFn: () => api('/api/reputation/response-sla'),
  });
  const [threshold, setThreshold] = useState<string>('');
  const [hours, setHours] = useState<string>('');
  // Seed the form from the loaded policy once it arrives.
  const s = settingsQ.data;
  useEffect(() => {
    if (s) { setThreshold((prev) => (prev === '' ? String(s.sla_rating_threshold) : prev)); setHours((prev) => (prev === '' ? String(s.sla_hours) : prev)); }
  }, [s]);

  const save = useMutation({
    mutationFn: () => api('/api/reputation/response-settings', { method: 'PUT', body: JSON.stringify({ slaRatingThreshold: Number(threshold), slaHours: Number(hours) }) }),
    onSuccess: () => { notifySuccess(t('rep.sla_saved')); qc.invalidateQueries({ queryKey: ['rep-sla-settings'] }); qc.invalidateQueries({ queryKey: ['rep-sla'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const worklistCols = [
    { key: 'author', label: t('rep.col_author'), render: (r: any) => r.author_name ?? '—' },
    { key: 'rating', label: t('rep.col_rating'), render: (r: any) => (r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '—') },
    { key: 'comment', label: t('rep.col_comment'), render: (r: any) => <span className="line-clamp-2 max-w-md">{r.comment ?? '—'}</span> },
    { key: 'age', label: t('rep.sla_col_age'), align: 'right' as const, render: (r: any) => `${Math.round(r.age_hours)}h` },
  ];

  return (
    <div className="space-y-4">
      <Card className="gap-3">
        <CardHeader><CardTitle className="text-base">{t('rep.sla_policy')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <div className="mb-1 text-muted-foreground">{t('rep.sla_threshold')}</div>
            <select value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-40 rounded border px-2 py-1">
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)} {t('rep.sla_or_below')}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <div className="mb-1 text-muted-foreground">{t('rep.sla_hours')}</div>
            <input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} className="w-32 rounded border px-2 py-1" />
          </label>
          <Button size="sm" disabled={save.isPending || !threshold || !hours} onClick={() => save.mutate()}><Save className="mr-1 size-3.5" />{t('rep.save')}</Button>
        </CardContent>
      </Card>

      <StateView q={slaQ}>
        {slaQ.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('rep.sla_breached')} value={num(slaQ.data.breach_count)} icon={AlarmClock} tone={slaQ.data.breach_count > 0 ? 'danger' : 'success'} />
              <StatCard label={t('rep.sla_open')} value={num(slaQ.data.open_count)} icon={Clock} tone={slaQ.data.open_count > 0 ? 'warning' : 'success'} />
              <StatCard label={t('rep.sla_policy_active')} value={`≤${slaQ.data.settings.sla_rating_threshold}★ · ${slaQ.data.settings.sla_hours}h`} icon={Settings2} tone="primary" />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">{t('rep.sla_breached')}</h3>
              <DataTable rows={slaQ.data.breaches} rowKey={(r: any) => r.id} emptyState={{ icon: AlarmClock, title: t('rep.sla_none_breached') }} columns={worklistCols} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">{t('rep.sla_open')}</h3>
              <DataTable rows={slaQ.data.open} rowKey={(r: any) => r.id} emptyState={{ icon: Clock, title: t('rep.sla_none_open') }} columns={worklistCols} />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

export default function ReputationPage() {
  const { t } = useLang();
  return (
    <div className="space-y-4">
      <PageHeader title={t('rep.title')} description={t('rep.subtitle')} />
      <Tabs tabs={[
        { key: 'conn', label: t('rep.tab_connections'), content: <Connections /> },
        { key: 'rev', label: t('rep.tab_reviews'), content: <Reviews /> },
        { key: 'sla', label: t('rep.tab_sla'), content: <SlaPanel /> },
        { key: 'an', label: t('rep.tab_analytics'), content: <AnalyticsPanel /> },
      ]} />
    </div>
  );
}
