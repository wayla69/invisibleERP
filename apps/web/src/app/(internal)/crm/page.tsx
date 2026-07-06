'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, ShoppingCart, Receipt, Users, Search, Cake, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SimpleBarChart } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

// GET /api/crm/branch-kpi → { date, today: {revenue, orders, avg_order_value, active_members},
//   by_channel: { [channel]: { count, revenue } }, hourly_revenue: [{ hour, revenue }] }
interface BranchKpi {
  date: string;
  today: { revenue: number; orders: number; avg_order_value: number; active_members: number };
  by_channel: Record<string, { count: number; revenue: number }>;
  hourly_revenue: { hour: number; revenue: number }[];
}

// GET /api/crm/profile/:memberId → 360 view
interface Profile {
  member: { id: number; member_code: string; name: string; phone: string | null; balance: number; lifetime: number; tier: string | null };
  crm: null | { rfm_segment: string; total_orders: number; total_spend: number; rfm_recency: number; rfm_frequency: number; rfm_monetary: number; preferred_channel: string | null; avg_order_value: number; refreshed_at: string };
  recent_orders: { order_no: string; total: number; channel: string; opened_at: string }[];
}

export default function CrmPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('crm.title')} description={t('crm.subtitle')} />
      <div className="space-y-6">
        <BranchKpi />
        <CustomerLookup />
        <Messaging />
      </div>
    </div>
  );
}

function BranchKpi() {
  const { t } = useLang();
  const q = useQuery<BranchKpi>({ queryKey: ['crm-branch-kpi'], queryFn: () => api('/api/crm/branch-kpi') });

  const channelRows = Object.entries(q.data?.by_channel ?? {}).map(([channel, v]) => ({
    channel,
    count: v.count,
    revenue: v.revenue,
  }));
  const hourly = (q.data?.hourly_revenue ?? []).map((r) => ({ label: `${String(r.hour).padStart(2, '0')}:00`, revenue: r.revenue }));

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{t('crm.data_for_date')}</span>
            <Badge variant="muted">{thaiDate(q.data.date)}</Badge>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('crm.sales_today')} value={baht(q.data.today.revenue)} icon={Banknote} tone="primary" />
            <StatCard label={t('crm.orders_today')} value={num(q.data.today.orders)} icon={ShoppingCart} tone="info" />
            <StatCard label={t('crm.avg_per_order')} value={baht(q.data.today.avg_order_value)} icon={Receipt} tone="default" />
            <StatCard label={t('crm.active_members_today')} value={num(q.data.today.active_members)} icon={Users} tone="success" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('crm.revenue_by_channel_today')}</CardTitle>
              </CardHeader>
              <CardContent>
                {channelRows.length ? (
                  <SimpleBarChart data={channelRows} xKey="channel" yKey="revenue" color="var(--chart-2)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('crm.no_sales_today')}</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('crm.revenue_hourly_today')}</CardTitle>
              </CardHeader>
              <CardContent>
                {q.data.today.revenue > 0 ? (
                  <SimpleBarChart data={hourly} xKey="label" yKey="revenue" color="var(--chart-1)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('crm.no_sales_today')}</div>
                )}
              </CardContent>
            </Card>
          </div>

          {channelRows.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('crm.summary_by_channel')}</h3>
              <DataTable
                rows={channelRows}
                columns={[
                  { key: 'channel', label: t('crm.channel') },
                  { key: 'count', label: t('crm.order_count'), align: 'right', render: (r) => <span className="tabular">{num(r.count)}</span> },
                  { key: 'revenue', label: t('crm.revenue'), align: 'right', render: (r) => <span className="tabular">{baht(r.revenue)}</span> },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </StateView>
  );
}

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

// RFM segments computed server-side (crm.service.ts): Champions / Loyal / At Risk / Lost / New.
const RFM_SEGMENTS = ['Champions', 'Loyal', 'At Risk', 'Lost', 'New'] as const;
const RFM_SEGMENT_KEYS: Record<string, string> = {
  Champions: 'crm.rfm_champions', Loyal: 'crm.rfm_loyal', 'At Risk': 'crm.rfm_at_risk', Lost: 'crm.rfm_lost', New: 'crm.rfm_new',
};
const rfmSegmentLabel = (t: (key: string) => string, s: string) => (RFM_SEGMENT_KEYS[s] ? t(RFM_SEGMENT_KEYS[s]) : s);

interface Member { id: number; member_code: string; name: string | null; phone: string | null }
interface Msg { id: number; channel: string; recipient: string | null; body: string; status: string; provider: string | null; campaign: string | null; created_at: string }

function Messaging() {
  const { t } = useLang();
  const qc = useQueryClient();
  const bdays = useQuery<{ window: string; count: number; members: Member[] }>({ queryKey: ['crm-birthdays'], queryFn: () => api('/api/loyalty/members/birthdays?window=month') });
  const log = useQuery<{ messages: Msg[] }>({ queryKey: ['crm-msg-log'], queryFn: () => api('/api/messaging/log?limit=20') });

  const [audience, setAudience] = useState('birthdays_today');
  const [segment, setSegment] = useState('Champions');
  const [channel, setChannel] = useState('sms');
  const [body, setBody] = useState('');

  const blast = useMutation({
    mutationFn: () => api<{ sent: number; skipped: number; targeted: number }>('/api/messaging/blast', { method: 'POST', body: JSON.stringify({ audience, segment: audience === 'segment' ? segment : undefined, channel, body }) }),
    onSuccess: (r) => { notifySuccess(t('crm.blast_result', { sent: r.sent, skipped: r.skipped, targeted: r.targeted })); setBody(''); qc.invalidateQueries({ queryKey: ['crm-msg-log'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Send className="size-4" /> {t('crm.marketing_messaging')}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-3">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Cake className="size-4 text-primary" /> {t('crm.birthdays_this_month')} ({num(bdays.data?.count ?? 0)})</h3>
            <StateView q={bdays}>
              <DataTable
                rows={bdays.data?.members ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'member_code', label: t('crm.col_code') },
                  { key: 'name', label: t('crm.col_name'), render: (r) => r.name ?? '—' },
                  { key: 'phone', label: t('crm.col_phone'), render: (r) => r.phone ?? '—' },
                ]}
                emptyState={{ icon: Cake, title: t('crm.no_birthdays') }}
              />
            </StateView>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <h3 className="text-sm font-semibold">{t('crm.send_to_segment')}</h3>
            <div className="flex flex-wrap gap-2">
              <select className={selectCls} aria-label={t('crm.audience')} value={audience} onChange={(e) => setAudience(e.target.value)}>
                <option value="birthdays_today">{t('crm.birthdays_today')}</option>
                <option value="segment">{t('crm.rfm_segment')}</option>
                <option value="all">{t('crm.all_members')}</option>
              </select>
              {audience === 'segment' && (
                <select className={selectCls} aria-label={t('crm.rfm_segment')} value={segment} onChange={(e) => setSegment(e.target.value)}>
                  {RFM_SEGMENTS.map((s) => <option key={s} value={s}>{t(RFM_SEGMENT_KEYS[s])}</option>)}
                </select>
              )}
              <select className={selectCls} aria-label={t('crm.send_channel')} value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="sms">SMS</option>
                <option value="line">LINE</option>
                <option value="email">Email</option>
              </select>
            </div>
            <Input value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('crm.message_to_customer')} placeholder={t('crm.message_placeholder')} />
            <Button disabled={!body.trim() || blast.isPending} onClick={() => blast.mutate()}><Send className="size-4" /> {blast.isPending ? t('crm.sending') : t('crm.send_message')}</Button>
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('crm.recent_sends')}</h3>
          <StateView q={log}>
            <DataTable
              rows={log.data?.messages ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: 'channel', label: t('crm.channel'), render: (r) => <Badge variant="info">{r.channel}</Badge> },
                { key: 'recipient', label: t('crm.recipient'), render: (r) => r.recipient ?? '—' },
                { key: 'body', label: t('crm.message'), render: (r) => <span className="line-clamp-1">{r.body}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'sent' ? 'success' : r.status === 'skipped' ? 'muted' : 'destructive'}>{r.status}</Badge> },
                { key: 'provider', label: t('crm.provider'), render: (r) => r.provider ?? '—' },
              ]}
              emptyState={{ icon: Send, title: t('crm.no_messages_title'), description: t('crm.no_messages_desc') }}
            />
          </StateView>
        </div>
      </CardContent>
    </Card>
  );
}

function CustomerLookup() {
  const { t } = useLang();
  const [input, setInput] = useState('');
  const [memberId, setMemberId] = useState<number | null>(null);

  const q = useQuery<Profile>({
    queryKey: ['crm-profile', memberId],
    queryFn: () => api(`/api/crm/profile/${memberId}`),
    enabled: memberId != null,
  });

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('crm.customer_360')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); const id = Number(input); if (Number.isFinite(id) && id > 0) setMemberId(id); }}
        >
          <div className="grid gap-2">
            <Label htmlFor="crm-member">{t('crm.member_id_label')}</Label>
            <Input id="crm-member" type="number" min="1" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('crm.member_id_placeholder')} className="w-40" />
          </div>
          <Button type="submit" disabled={!input.trim()}>
            <Search className="size-4" /> {t('crm.search')}
          </Button>
        </form>

        {memberId != null && (
          <StateView q={q}>
            {q.data && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    label={q.data.member.name || q.data.member.member_code}
                    value={
                      q.data.crm
                        ? <Badge variant={statusVariant(q.data.crm.rfm_segment)}>{rfmSegmentLabel(t, q.data.crm.rfm_segment)}</Badge>
                        : <Badge variant="muted">{t('crm.no_rfm_profile')}</Badge>
                    }
                    hint={`${q.data.member.member_code}${q.data.member.tier ? ` · ${q.data.member.tier}` : ''}`}
                  />
                  <StatCard label={t('crm.lifetime_value')} value={baht(q.data.member.lifetime)} tone="primary" />
                  <StatCard label={t('crm.total_spend')} value={baht(q.data.crm?.total_spend ?? 0)} tone="info" hint={t('crm.orders_n', { n: num(q.data.crm?.total_orders ?? 0) })} />
                  <StatCard label={t('crm.avg_per_order')} value={baht(q.data.crm?.avg_order_value ?? 0)} />
                </div>

                {q.data.crm && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <StatCard label={t('crm.recency_label')} value={num(q.data.crm.rfm_recency)} hint={t('crm.recency_hint')} />
                    <StatCard label={t('crm.frequency_label')} value={num(q.data.crm.rfm_frequency)} hint={t('crm.frequency_hint')} />
                    <StatCard label={t('crm.monetary_label')} value={baht(q.data.crm.rfm_monetary)} hint={q.data.crm.preferred_channel ? t('crm.preferred_channel', { ch: q.data.crm.preferred_channel }) : undefined} />
                  </div>
                )}

                <div>
                  <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('crm.recent_orders')}</h3>
                  <DataTable
                    rows={q.data.recent_orders}
                    emptyState={{ icon: Receipt, title: t('crm.no_orders_title'), description: t('crm.no_orders_desc') }}
                    columns={[
                      { key: 'order_no', label: t('dash.col_no') },
                      { key: 'channel', label: t('crm.channel'), render: (r) => <Badge variant="info">{r.channel}</Badge> },
                      { key: 'opened_at', label: t('dash.col_date'), render: (r) => thaiDate(r.opened_at) },
                      { key: 'total', label: t('fin.col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.total)}</span> },
                    ]}
                  />
                </div>
              </div>
            )}
          </StateView>
        )}
      </CardContent>
    </Card>
  );
}
