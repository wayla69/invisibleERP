'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Users, Tag } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
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
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const g = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k]; return ''; };

function Campaigns() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['mk-camp'], queryFn: () => api('/api/marketing/campaigns') });
  const [name, setName] = useState(''); const [type, setType] = useState('Popup');
  const add = useMutation({ mutationFn: () => api('/api/marketing/campaigns', { method: 'POST', body: JSON.stringify({ campaign_name: name, campaign_type: type }) }), onSuccess: () => { notifySuccess(t('ly.mk_campaign_created')); qc.invalidateQueries({ queryKey: ['mk-camp'] }); setName(''); }, onError: (e: any) => notifyError(e.message) });
  const toggle = useMutation({ mutationFn: (id: number) => api(`/api/marketing/campaigns/${id}/toggle`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mk-camp'] }), onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card className="max-w-xl gap-4 p-5">
        <CardContent className="px-0">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="max-w-xs" placeholder={t('ly.campaign_name')} value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Popup">Popup</SelectItem>
                <SelectItem value="Ticker">Ticker</SelectItem>
                <SelectItem value="Banner">Banner</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>{t('ly.create')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.campaigns} emptyState={{ icon: Megaphone, title: t('ly.no_campaigns'), description: t('ly.no_campaigns_desc') }} columns={[
          { key: 'name', label: t('ly.col_name'), render: (r) => g(r, 'campaignName', 'campaign_name') },
          { key: 'type', label: t('ly.col_type'), render: (r) => g(r, 'campaignType', 'campaign_type') },
          { key: 'dates', label: t('ly.col_period'), render: (r) => `${thaiDate(g(r, 'startDate', 'start_date'))} – ${thaiDate(g(r, 'endDate', 'end_date'))}` },
          { key: 'active', label: t('fin.col_status'), render: (r) => { const s = r.active ? 'Active' : 'Paused'; return <Badge variant={statusVariant(s)}>{s}</Badge>; } },
          { key: 'x', label: '', sortable: false, render: (r) => <Button variant="secondary" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(r.id)}>{t('ly.toggle')}</Button> },
        ]} />}
      </StateView>
    </div>
  );
}

function Segments() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['mk-seg'], queryFn: () => api('/api/marketing/segments') });
  const d = q.data;
  return (
    <StateView q={q}>
      {d && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Object.entries(d.counts ?? {}).map(([k, v]) => <StatCard key={k} label={k} value={String(v)} />)}
          </div>
          <DataTable rows={d.segments ?? []} emptyState={{ icon: Users, title: t('ly.no_segments'), description: t('ly.no_segments_desc') }} columns={[
            { key: 'name', label: t('fin.col_customer'), render: (r) => g(r, 'tenant', 'customer_name', 'code') },
            { key: 'segment', label: t('ly.col_group'), render: (r) => { const s = g(r, 'segment'); return <Badge variant={statusVariant(s)}>{s}</Badge>; } },
            { key: 'spend', label: t('ly.col_spend'), align: 'right', render: (r) => baht(g(r, 'spend', 'total_spend')) },
            { key: 'orders', label: t('ly.col_orders'), align: 'right', render: (r) => g(r, 'order_count', 'orders') },
            { key: 'days', label: t('ly.col_recency'), align: 'right', render: (r) => g(r, 'days_since', 'days') },
          ]} />
        </div>
      )}
    </StateView>
  );
}

function Promotions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['mk-promo'], queryFn: () => api('/api/promotions') });
  const [name, setName] = useState(''); const [type, setType] = useState('Discount %'); const [pct, setPct] = useState(10);
  const add = useMutation({ mutationFn: () => api('/api/promotions', { method: 'POST', body: JSON.stringify({ promo_name: name, promo_type: type, discount_pct: Number(pct) }) }), onSuccess: () => { notifySuccess(t('ly.mk_promo_created')); qc.invalidateQueries({ queryKey: ['mk-promo'] }); setName(''); }, onError: (e: any) => notifyError(e.message) });
  const toggle = useMutation({ mutationFn: (id: number) => api(`/api/promotions/${id}/toggle`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mk-promo'] }), onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card className="max-w-2xl gap-4 p-5">
        <CardContent className="px-0">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="max-w-xs" placeholder={t('ly.promo_name_ph')} value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="w-24" type="number" value={pct} onChange={(e) => setPct(+e.target.value)} />
            <span className="text-sm text-muted-foreground">{t('ly.pct_off')}</span>
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>{t('ly.create')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.promotions} emptyState={{ icon: Tag, title: t('ly.no_promos'), description: t('ly.no_promos_desc') }} columns={[
          { key: 'name', label: t('ly.col_name'), render: (r) => g(r, 'promoName', 'promo_name') },
          { key: 'type', label: t('ly.col_type'), render: (r) => g(r, 'promoType', 'promo_type') },
          { key: 'active', label: t('fin.col_status'), render: (r) => { const s = g(r, 'active', 'isActive') ? 'Active' : 'Paused'; return <Badge variant={statusVariant(s)}>{s}</Badge>; } },
          { key: 'x', label: '', sortable: false, render: (r) => <Button variant="secondary" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(g(r, 'id'))}>{t('ly.toggle')}</Button> },
        ]} />}
      </StateView>
    </div>
  );
}

export default function Marketing() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('ly.mk_title')} description={t('ly.mk_desc')} />
      <Tabs tabs={[
        { key: 'c', label: t('ly.tab_campaigns'), content: <Campaigns /> },
        { key: 's', label: t('ly.tab_segments'), content: <Segments /> },
        { key: 'p', label: t('ly.tab_promotions'), content: <Promotions /> },
      ]} />
    </div>
  );
}
